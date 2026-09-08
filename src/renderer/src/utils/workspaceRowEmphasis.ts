// How loudly a chat row is drawn. TWO tiers, because a sidebar of forty chats
// has one question to answer about any one of them: is anyone using this, or
// is it sitting in the background?
//
// Owner ruling 2026-09-07 (contrast-for-quiet-chats): a list
// where every row is drawn at full ink has no foreground. It landed as three
// tiers first — lead, in-play, quiet — and the middle one was struck the same
// day: three steps of text contrast on one column is a ladder the eye has to
// read rather than a foreground it can see. In-play folded up into the bold
// tier, and the background tier went a step DOWN the ink scale to widen the
// gap that is actually load-bearing.
//
//  - `active` — someone is using this chat: it is the row you are in, an agent
//               on it is working, it wants you (blocked on a prompt, or
//               finished while you were away), or a person touched it inside
//               the hour. Bold, at the row's own ink. The one selected row
//               also takes the ink lift, which is selection's channel and no
//               one else's (`design-system/patterns/selection.html`).
//  - `quiet`  — background: resting on the shelf, or simply not touched for an
//               hour. Not bold, and dimmer than the row spec's resting ink —
//               `text.subtle` rather than `text.muted`, deliberately below
//               list-row's Rest, which on this near-black rail still read as
//               foreground. It lifts back on hover, so reaching for a
//               background chat is never reading dim text.
export type WorkspaceRowEmphasis = 'active' | 'quiet'

// A chat with nothing happening on it for this long is background. Deliberately
// far short of the rest threshold (`WORKSPACE_AUTO_SETTLE_AFTER_MS`, three
// days): dimming and settling answer different questions — "is anyone using
// this right now" versus "is this chat over" — and the hours between them are
// exactly the rows the owner pointed at, chats that are still on the list and
// still theirs but that nobody is in.
export const WORKSPACE_ROW_QUIET_AFTER_MS = 60 * 60 * 1000 // 1 hour

/**
 * The tier for one row. Pure: everything live — selection, what the agent is
 * doing, the unseen finished mark — arrives as a flag, because the sidebar is
 * the only thing that knows them and this must not grow a second opinion.
 *
 * `lastActiveAt` is when the chat last did anything, by anyone: the clock the
 * row's own "2h" label reads (`TerminalRecency.idleSince`), so what the row
 * says and how loudly it says it can never disagree. Null when nothing is
 * known — a row with no clock has no claim on the foreground.
 */
export function workspaceRowEmphasis(input: {
  /** The row you are in, in this window. */
  selected: boolean
  /** An agent on this row is mid-turn. */
  working: boolean
  /** Blocked on a prompt, or the unseen "finished while you were away" mark. */
  wantsYou: boolean
  /** Resting on its folder's Settled shelf. */
  settled: boolean
  lastActiveAt: number | null
  now: number
}): WorkspaceRowEmphasis {
  const { selected, working, wantsYou, settled, lastActiveAt, now } = input
  if (selected || working || wantsYou) return 'active'
  if (settled) return 'quiet'
  if (lastActiveAt === null) return 'quiet'
  return now - lastActiveAt >= WORKSPACE_ROW_QUIET_AFTER_MS ? 'quiet' : 'active'
}
