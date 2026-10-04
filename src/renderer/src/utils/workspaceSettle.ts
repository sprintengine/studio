import type { Workspace } from '../types/workspace'
import type { BranchPullRequest } from '../../../shared/git/pull-request'
import type { WorkspaceFieldsPatch } from '../../../shared/workspace-sync'
import { deriveWorkspaceRunGlyph } from './workspaceRunGlyph'
import { isStarred } from './highlight'
import { isSnoozeUnexpired, wakeSnoozedWorkspacePatch } from './workspaceSnooze'
import { workspaceLastActiveAt, workspaceLastUserMessageAt } from './workspaceRecency'
import type { LifecycleState } from '../../../shared/lifecycle-state'

// A chat settles — moves from its folder's active list into the folder's
// Settled shelf — once it has gone this long without activity. One constant,
// on purpose: the fold this replaces was also a single unconfigurable
// threshold, and three days is long enough that a chat someone means to come
// back to tomorrow is never swept out from under them. Settling keeps the
// workspace on disk and in the store, and opening it brings it back — but it
// is no longer free of consequence: a resting chat holds no terminals (owner
// ruling 2026-09-07), so the ptys are killed with the row and the agent
// resumes from its CLI session when the chat is next opened. This module
// still only DECIDES; the sidebar carries the decision out.
export const WORKSPACE_AUTO_SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

// Module-owned run states that must never settle on their own, no matter how
// old: anything still in flight or waiting on the person. Carried over from the
// archive sweep this rule replaces.
const PINNED_RUN_STATES: ReadonlySet<LifecycleState> = new Set(['in_progress', 'needs_input', 'paused', 'failed'])

// The chat's own activity clock lives with the other clocks now
// (`workspaceRecency.ts`), where the flat stream's ordering can read it
// without the rest rules and the sort importing each other. Re-exported here
// because the rest rule is what it was written for and what most callers of
// it are reasoning about.
export { workspaceLastActiveAt } from './workspaceRecency'

/**
 * What the rest rule reads besides the record and the clock: the chat's pull
 * requests (the Studio server's list for the workspace), and whether a merge
 * settles a chat at all (Settings ▸ Settled chats).
 */
export type AutoSettleContext = {
  pullRequests?: readonly BranchPullRequest[]
  settleOnMerge?: boolean
}

/** The one answer to "is this row resting?". */
export function isSettledWorkspace(workspace: Pick<Workspace, 'settledAt'>): boolean {
  return typeof workspace.settledAt === 'number'
}

/**
 * The pure idle rule: true when a row that is not otherwise exempt has been
 * quiet for the threshold. The live blockers — the active row of any window,
 * a working or blocked agent, the unseen finished mark — live with the
 * caller, which knows them; this reads only the record and the clock.
 *
 * Exempt for good, whatever the clock says: a row already resting, a row with
 * a hand decision on it (`settledOverride`), a starred row (the star is the
 * person saying "keep this in front of me"), a row born on a paired machine
 * (the Remote band has its own model), the rail-hidden hosts, a row whose
 * module reports a run still in flight, and a row the person took out of
 * auto-settling from its menu (`autoSettleDisabled`).
 *
 * Two ways in: three quiet days, or its pull requests landing
 * (`pullRequestsLanded`) when Settle on merge is on.
 */
export function shouldAutoSettleWorkspace(workspace: Workspace, now: number, context: AutoSettleContext = {}): boolean {
  if (isSettledWorkspace(workspace)) return false
  if (workspace.settledOverride != null) return false
  if (workspace.autoSettleDisabled === true) return false
  // A running snooze is a hand decision about this row's near future, and the
  // sweep never overrules one of those. Settling a row mid-snooze would strand
  // the person's "ask me again in an hour" behind an Un-settle they never asked
  // for. The plain timer test is enough: a row whose hand is up is `held` on
  // the caller's terms and is not a settle candidate anyway.
  if (isSnoozeUnexpired(workspace, now)) return false
  if (isStarred(workspace.highlight)) return false
  if (workspace.remoteOrigin) return false
  const glyph = deriveWorkspaceRunGlyph(workspace)
  if (glyph && PINNED_RUN_STATES.has(glyph.state)) return false
  if (now - workspaceLastActiveAt(workspace) >= WORKSPACE_AUTO_SETTLE_AFTER_MS) return true
  return context.settleOnMerge === true && pullRequestsLanded(workspace, context.pullRequests ?? [])
}

/**
 * Whether a chat's work has landed: it has pull requests, none is still open,
 * at least one merged, and the person has not written to the chat since the
 * last of them ended. A chat whose pull requests all closed unmerged did not
 * land; the idle rule settles it in time. A message after the merge is the
 * person carrying on — a follow-up, a question about what landed — and the
 * chat stays.
 *
 * "Written to" is the person's last input of any kind: a message, or a
 * keystroke into one of the chat's terminals (a dev server started in its
 * shell after the merge is carrying on too, and settling would kill it).
 *
 * An entry with no end time (one read before the record kept it) cannot say
 * whether the person wrote after it, so it holds the chat for the idle rule.
 */
export function pullRequestsLanded(workspace: Workspace, pullRequests: readonly BranchPullRequest[]): boolean {
  if (pullRequests.length === 0) return false
  let lastEnded = 0
  for (const pr of pullRequests) {
    if (pr.state === 'open' || typeof pr.endedAt !== 'number') return false
    lastEnded = Math.max(lastEnded, pr.endedAt)
  }
  if (!pullRequests.some((pr) => pr.state === 'merged')) return false
  return lastEnded >= Math.max(workspaceLastUserMessageAt(workspace), workspace.lastTerminalActivityAt ?? 0)
}

/**
 * What the sweep should do to one row, given what only the caller knows.
 * Returned as a decision rather than applied, so the store action and its
 * test read the same three words.
 *
 *  - `busy`: the agent is working — activity. It wakes a resting row (a hand
 *    Settle included: new activity resumes the usual rules, the same way a
 *    keystroke does) and blocks settling an active one.
 *  - `held`: the row wants the person — blocked on a prompt, or wearing the
 *    unseen "finished while you were away" mark. A thing to look at, not
 *    activity: it blocks settling, and it wakes a row the SWEEP settled (a
 *    row that wants the person does not belong in the shelf unless the
 *    person put it there — the sweep can only have settled it on a reading
 *    taken before the sessions were known). It never wakes a hand Settle: a
 *    prompt is a persistent state that was already true when Settle was
 *    chosen, so treating it as a wake would undo every Settle within a tick
 *    until the prompt is answered.
 *  - `active`: the row someone is looking at in some window. Being looked at
 *    is not activity either: selecting a settled row to read it keeps it
 *    settled, and an active row that has gone quiet is simply never settled
 *    out from under the person.
 */
export type SettlementDecision = 'wake' | 'settle' | 'none'

export function decideWorkspaceSettlement(input: {
  workspace: Workspace
  now: number
  active: boolean
  busy: boolean
  held: boolean
  context?: AutoSettleContext
}): SettlementDecision {
  const { workspace, now, active, busy, held } = input
  if (isSettledWorkspace(workspace)) {
    if (busy) return 'wake'
    return held && workspace.settledOverride == null ? 'wake' : 'none'
  }
  if (active || busy || held) return 'none'
  return shouldAutoSettleWorkspace(workspace, now, input.context) ? 'settle' : 'none'
}

/**
 * The two transitions as registry field patches, so every writer — the
 * sweep, the row menu, the keystroke path — changes the same fields the same
 * way and the store's copies cannot drift.
 *
 * A patch that puts a row to rest also carries the person's last-input clock
 * as the store knows it. Main's copy of that clock is otherwise refreshed on a
 * coarse cadence, and a restart rebuilds the row from main's record: a
 * keystroke that never reached main would then read as NEWER than the rest
 * decision and wake the row the moment its session was listed. Sending the
 * clock with the decision makes main at least as current as the decision.
 */
export function settleWorkspacePatch(
  workspace: Pick<Workspace, 'lastTerminalActivityAt'>,
  now: number,
  override: 'settled' | null,
): WorkspaceFieldsPatch {
  return {
    // Rest supersedes sleep (snooze, 2026-09-10). A settled row is out of the
    // list for good reasons of its own, so a snooze underneath it would do
    // nothing visible and then expire into a Woke mark on a row nobody woke.
    // Cleared HERE rather than at each call site so the sweep, the row menu and
    // the hover tick cannot disagree about it.
    ...wakeSnoozedWorkspacePatch(),
    settledAt: now,
    settledOverride: override,
    ...(typeof workspace.lastTerminalActivityAt === 'number'
      ? { lastTerminalActivityAt: workspace.lastTerminalActivityAt }
      : {}),
  }
}

export function wakeWorkspacePatch(override: 'active' | null): WorkspaceFieldsPatch {
  return { settledAt: null, settledOverride: override }
}
