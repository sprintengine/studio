import type { Workspace } from '../types/workspace'
import type { WorkspaceFieldsPatch } from '../../../shared/workspace-sync'

// Snooze: "not now, ask me again at <time>" (owner ruling, 2026-09-10).
//
// A snoozed chat STOPS RUNNING and comes back on a clock. Its terminals are
// suspended, so it sits exactly as the app's other non-live chats do — no agent
// process, just a row — and when the wake time passes the row simply returns to
// the sidebar. Nothing is relaunched: the person's first keystroke resumes the
// agent under its own session id with `--resume`, the same way returning to a
// paused chat has always worked (owner ruling, 2026-09-10).
//
// Snooze first shipped visibility-only, on the rule that a snooze never touches
// the agent. That rule does not survive here: visibility-only suits a snooze
// whose session lives on a SERVER, where hiding costs nothing, while ours holds
// a live local process — so "hidden" meant a chat you had told to go away was
// the most expensive row in the tree. The suspend lives in
// `components/workspace/workspaceTerminalTermination.ts`; this module still
// only decides WHEN a row is asleep.
//
// Suspend, not kill, is the whole distinction from Settle — which says the work
// is DONE and drops the ptys outright (owner ruling 2026-09-07). A snoozed chat
// is coming back on a known clock, so its session is kept resumable.
//
// TIMER WAKES ARE DERIVED, NOT SCHEDULED. There is no timer, no sweep entry and
// no wake event: a row is snoozed while `snoozedUntil` is in the future, and
// stops being snoozed when it is not. The sidebar already re-renders on
// `useRelativeNow`'s tick, so the wake costs nothing and — the real prize —
// survives a restart, a window move and a machine asleep past the wake time
// with no recovery path to get wrong.
//
// This module only DECIDES. The sidebar renders the decision; the store writes
// the fields. Same division as `workspaceSettle.ts`, whose shape this mirrors
// on purpose — the two rules are read side by side.

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Wake hour for "This evening". */
const EVENING_HOUR = 18
/** Wake hour for the calendar presets ("Tomorrow", "Next week"). */
const MORNING_HOUR = 9

export type SnoozePresetId = 'hour' | 'three-hours' | 'evening' | 'tomorrow' | 'next-week'

export type SnoozePreset = {
  readonly id: SnoozePresetId
  /** The choice, as the person makes it: "In 1 hour", "Tomorrow". */
  readonly label: string
  /**
   * The wake time the choice lands on, for the menu row's second column. It
   * COMPLEMENTS the label rather than repeating it — "Tomorrow" pairs with
   * "9:00 am", not with "tomorrow 9:00 am" — so the person can see that
   * "Tomorrow" means the morning and not this time tomorrow.
   */
  readonly whenLabel: string
  readonly wakeAt: number
}

function timeOfDayLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function weekdayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short' })
}

/** The given clock hour on `base`'s own calendar day, at the top of the hour. */
function atHour(base: number, hour: number): number {
  const date = new Date(base)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

// Calendar-day arithmetic, NOT `+ n * DAY_MS`. A fixed millisecond offset lands
// on the wrong local day across a DST transition — a spring-forward day is 23
// hours, so 23:30 + 24h skips the whole next day — and "Tomorrow" landing on
// the day after tomorrow twice a year is the kind of bug nobody reports and
// everybody distrusts the feature for.
function addDays(base: number, days: number): number {
  const date = new Date(base)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * The wake times on offer, resolved against a clock so the labels say when each
 * one actually lands.
 *
 * Two presets are relative ("in an hour") and the rest are calendar points, and
 * a calendar point only earns a row while it is still in front of you:
 *
 *  - "This evening" appears only while evening is more than an hour away.
 *    Offering it at 17:55 is offering a five-minute snooze under a name that
 *    promises the rest of the afternoon.
 *  - "Next week" collapses into "Tomorrow" when they are the same instant,
 *    which is every Sunday. Two rows, one wake time, is a menu that looks like
 *    it is offering a choice it is not.
 */
export function resolveSnoozePresets(now: number): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    {
      id: 'hour',
      label: 'In 1 hour',
      whenLabel: timeOfDayLabel(now + HOUR_MS),
      wakeAt: now + HOUR_MS,
    },
    {
      id: 'three-hours',
      label: 'In 3 hours',
      whenLabel: timeOfDayLabel(now + 3 * HOUR_MS),
      wakeAt: now + 3 * HOUR_MS,
    },
  ]

  const evening = atHour(now, EVENING_HOUR)
  if (evening - now > HOUR_MS) {
    presets.push({
      id: 'evening',
      label: 'This evening',
      whenLabel: timeOfDayLabel(evening),
      wakeAt: evening,
    })
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR)
  presets.push({
    id: 'tomorrow',
    label: 'Tomorrow',
    whenLabel: timeOfDayLabel(tomorrow),
    wakeAt: tomorrow,
  })

  // The coming Monday. `|| 7` keeps Monday itself meaning "a week from now"
  // rather than "today".
  const daysUntilMonday = (1 - new Date(now).getDay() + 7) % 7 || 7
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR)
  if (nextWeek !== tomorrow) {
    presets.push({
      id: 'next-week',
      label: 'Next week',
      whenLabel: `${weekdayLabel(nextWeek)} ${timeOfDayLabel(nextWeek)}`,
      wakeAt: nextWeek,
    })
  }

  return presets
}

/** Does this row carry a snooze at all — awake or not? The field test, nothing more. */
export function hasSnooze(workspace: Pick<Workspace, 'snoozedUntil'>): boolean {
  return typeof workspace.snoozedUntil === 'number' && Number.isFinite(workspace.snoozedUntil)
}

/**
 * What only the caller knows about a row, in the terms this module reasons in.
 * Derived from live sessions the store does not hold, so it arrives as an
 * argument exactly as `decideWorkspaceSettlement`'s blockers do.
 */
export type SnoozeLiveState = {
  /** The agent is blocked on the person — a prompt, an approval, a question. */
  readonly needsInput: boolean
}

/**
 * A snoozed row RAISES ITS HAND when something outranks the person's "not now":
 *
 *  - the agent is blocked on them. Hiding a question defeats the question, and
 *    this can only have become true since the snooze — a row that was already
 *    asking could not be snoozed (`canSnoozeWorkspace`).
 *  - a turn ended after the snooze was set. Strictly AFTER: a row snoozed with
 *    a finished turn already on it was the person saying "I saw that, not now",
 *    and re-reading the same timestamp as news would wake it instantly, every
 *    tick, forever.
 *
 * A SAFETY NET, not a headline feature. Snoozing suspends the chat's terminals,
 * so a sleeping chat has no agent process and normally cannot produce either
 * signal. What is left are the cases where it still can: a pane mounted from
 * another machine, whose pty lives on that machine and is not ours to suspend,
 * and a suspend that failed. In both, the chat is genuinely still running, and
 * a row still running is a row the shelf should give back.
 *
 * Raising a hand never clears the stored fields — it only stops the row
 * classifying as snoozed, which is what feeds the Woke mark.
 */
export function workspaceRaisedHandWhileSnoozed(
  workspace: Pick<Workspace, 'snoozedAt' | 'lastTurnEndedAt'>,
  live: SnoozeLiveState
): boolean {
  if (live.needsInput) return true
  const { snoozedAt, lastTurnEndedAt } = workspace
  return (
    typeof snoozedAt === 'number' &&
    typeof lastTurnEndedAt === 'number' &&
    lastTurnEndedAt > snoozedAt
  )
}

/**
 * The pure timer test, with no live state: is the wake time still ahead?
 *
 * This is what the SETTLE sweep asks, and why it can ask it without knowing
 * about prompts: a row whose hand is up is `held` on the sweep's own terms and
 * is not a settle candidate anyway.
 */
export function isSnoozeUnexpired(workspace: Pick<Workspace, 'snoozedUntil'>, now: number): boolean {
  return hasSnooze(workspace) && (workspace.snoozedUntil as number) > now
}

/** The one answer to "is this row asleep right now?". */
export function isSnoozedWorkspace(
  workspace: Pick<Workspace, 'snoozedUntil' | 'snoozedAt' | 'lastTurnEndedAt'>,
  now: number,
  live: SnoozeLiveState
): boolean {
  if (!isSnoozeUnexpired(workspace, now)) return false
  return !workspaceRaisedHandWhileSnoozed(workspace, live)
}

/**
 * May this row be snoozed at all?
 *
 * A row already blocked on the person may not: hiding the question defeats it,
 * and it would raise its hand on the next tick regardless. A row already at
 * rest may not either — Settle has already taken it out of the list, and a
 * snooze underneath it would do nothing visible and then expire into a Woke
 * mark on a row nobody woke.
 *
 * A WORKING agent may be snoozed, and suspending it interrupts the turn (owner,
 * 2026-09-10: "it shouldn't matter if there's an agent in progress"). That is
 * the same licence a hand Settle already has, and it costs less here: the CLI
 * session survives the suspend, so resuming picks the conversation back up
 * rather than starting over.
 */
export function canSnoozeWorkspace(
  workspace: Pick<Workspace, 'settledAt' | 'remoteOrigin'>,
  live: SnoozeLiveState
): boolean {
  if (live.needsInput) return false
  if (typeof workspace.settledAt === 'number') return false
  // A row born on a paired machine lives in the Remote band, which has no
  // shelves to hide it in — the same rule Settle follows for the same reason.
  if (workspace.remoteOrigin) return false
  return true
}

/**
 * When a snooze ENDED, or null while it is still running (or never ran).
 *
 * This is the Woke mark: the sidebar's order is deliberately static, so a row
 * that comes back does not move to announce itself and needs to say so on its
 * own face. Cleared by opening the row — the mark exists to get you there.
 *
 * A hand-raised wake reports the moment that RAISED it, not the scheduled wake
 * time, so a row that woke early is not later re-dated to a wake that never
 * happened.
 */
export function workspaceWokeAt(
  workspace: Pick<Workspace, 'snoozedUntil' | 'snoozedAt' | 'lastTurnEndedAt'>,
  now: number,
  live: SnoozeLiveState
): number | null {
  if (!hasSnooze(workspace)) return null
  const wakeAt = workspace.snoozedUntil as number
  if (workspaceRaisedHandWhileSnoozed(workspace, live)) {
    const { snoozedAt, lastTurnEndedAt } = workspace
    if (
      typeof snoozedAt === 'number' &&
      typeof lastTurnEndedAt === 'number' &&
      lastTurnEndedAt > snoozedAt
    ) {
      return lastTurnEndedAt
    }
    return typeof snoozedAt === 'number' ? snoozedAt : wakeAt
  }
  return wakeAt <= now ? wakeAt : null
}

/**
 * The countdown a sleeping row wears: "42m", "2h", "3d". Minutes round UP so a
 * row that is still hidden never reads "0m" — a zero on a row you cannot see is
 * the interface calling itself broken.
 *
 * Deliberately not `formatRelativeMs`: that one floors, blanks under a minute
 * and reads backwards (how long ago), and all three are wrong for a countdown.
 */
export function snoozeWakeLabel(wakeAt: number, now: number): string {
  const remaining = wakeAt - now
  if (remaining <= 0) return 'now'
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`
  return `${Math.ceil(remaining / DAY_MS)}d`
}

/**
 * The two transitions as registry field patches, so the row menu, the wake
 * button and the store's clock paths all write the same fields the same way —
 * the reason `workspaceSettle.ts` hands out patches rather than letting each
 * caller assemble one.
 *
 * `snoozedAt` is the second half of the pair and not bookkeeping: it is the
 * line a turn end has to be newer than to count as news, so a snooze without
 * it would wake on the turn that finished before it.
 */
export function snoozeWorkspacePatch(wakeAt: number, now: number): WorkspaceFieldsPatch {
  return { snoozedUntil: wakeAt, snoozedAt: now }
}

export function wakeSnoozedWorkspacePatch(): WorkspaceFieldsPatch {
  return { snoozedUntil: null, snoozedAt: null }
}
