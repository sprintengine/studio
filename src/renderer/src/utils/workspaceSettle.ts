import type { Workspace } from '../types/workspace'
import type { WorkspaceFieldsPatch } from '../../../shared/workspace-sync'
import { deriveSprintEngineRunGlyph } from './sprintengine'
import { isSprintEngineWorkspace } from './sprintEngineWorkspace'
import { isStarred } from './highlight'
import { workspaceLastWorkedAt } from './workspaceRecency'
import { AUTOMATIONS_HOST_WORKSPACE_MODE, REVIEWS_HOST_WORKSPACE_MODE } from '../types/workspace'
import type { LifecycleState } from '../components/ui/LifecycleGlyph'

// A chat settles — moves from its folder's active list into the folder's
// Settled shelf — once it has gone this long without activity. One constant,
// on purpose: three days is shared by all chats, and the fold this
// replaces was also a single unconfigurable threshold. Settling is
// presentation-level tidiness: the workspace stays on disk and in the store,
// its terminals keep whatever state they had, and input into it wakes it.
export const WORKSPACE_AUTO_SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

// Sprint run states that must never settle on their own, no matter how old:
// anything still in flight or waiting on the person, including a finished
// branch that has not merged yet. Carried over from the archive sweep this
// rule replaces.
const PINNED_RUN_STATES: ReadonlySet<LifecycleState> = new Set([
  'in_progress',
  'needs_input',
  'paused',
  'failed',
  'changes_requested',
  'done_unmerged',
])

/** The one answer to "is this row resting?". */
export function isSettledWorkspace(workspace: Pick<Workspace, 'settledAt'>): boolean {
  return typeof workspace.settledAt === 'number'
}

/**
 * When the chat was last active, by anyone: the later of the person's last
 * real work (creation or a keystroke, `workspaceLastWorkedAt`) and the
 * agent's last turn end. Recency ordering deliberately reads only the
 * person's work — an agent finishing must not reshuffle the list — but rest
 * is about the whole chat going quiet, and a turn that ended yesterday is
 * not three idle days.
 */
export function workspaceLastActiveAt(workspace: Workspace): number {
  return Math.max(workspaceLastWorkedAt(workspace), workspace.lastTurnEndedAt ?? 0)
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
 * (the Remote band has its own model), the rail-hidden hosts, and a sprint
 * run still in flight.
 */
export function shouldAutoSettleWorkspace(workspace: Workspace, now: number): boolean {
  if (isSettledWorkspace(workspace)) return false
  if (workspace.settledOverride != null) return false
  if (isStarred(workspace.highlight)) return false
  if (workspace.remoteOrigin) return false
  if (workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE) return false
  if (workspace.mode === REVIEWS_HOST_WORKSPACE_MODE) return false
  if (now - workspaceLastActiveAt(workspace) < WORKSPACE_AUTO_SETTLE_AFTER_MS) return false
  if (isSprintEngineWorkspace(workspace)) {
    const glyph = deriveSprintEngineRunGlyph({
      sprintEngineState: workspace.sprintEngineState,
      autoState: workspace.sprintEngineAutoState,
    })
    if (glyph && PINNED_RUN_STATES.has(glyph.state)) return false
  }
  return true
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
}): SettlementDecision {
  const { workspace, now, active, busy, held } = input
  if (isSettledWorkspace(workspace)) {
    if (busy) return 'wake'
    return held && workspace.settledOverride == null ? 'wake' : 'none'
  }
  if (active || busy || held) return 'none'
  return shouldAutoSettleWorkspace(workspace, now) ? 'settle' : 'none'
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
  override: 'settled' | null
): WorkspaceFieldsPatch {
  return {
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
