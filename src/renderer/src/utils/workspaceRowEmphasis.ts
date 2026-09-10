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
// Owner ruling 2026-09-09: the clock is out and the agent is in. A chat touched
// inside the hour used to reach the foreground on its timestamp alone, which
// lit rows nobody was in and no agent was on — finish with a chat and it held
// its weight for another hour. What lights a row now is an agent ALIVE in it: a
// live session is a thing you can switch into and speak to, and when the last
// one is gone the chat is a record, however lately it was written. This
// reverses that half of the 2026-09-07 ruling, which had stripped residency of
// any visual channel; the argument then was that a live pty on an untouched
// chat is not motion, and the answer now is that it does not have to be motion
// to be the place where the work is.
//
//  - `active` — an agent is alive in this chat, or it is the row you are in, or
//               it wants you (blocked on a prompt, or finished while you were
//               away). Bold, at the row's own ink. The one selected row also
//               takes the ink lift, which is selection's channel and no one
//               else's (`design-system/patterns/selection.html`).
//  - `quiet`  — no agent left in it: a record, not a workbench. Not bold, and
//               dimmer than the row spec's resting ink — `text.subtle` rather
//               than `text.muted`, deliberately below list-row's Rest, which on
//               this near-black rail still read as foreground. It lifts back on
//               hover, so reaching for a background chat is never reading dim
//               text.
export type WorkspaceRowEmphasis = 'active' | 'quiet'

/**
 * The tier for one row. Pure: everything live — selection, residency, what the
 * agent is doing, the unseen finished mark — arrives as a flag, because the
 * sidebar is the only thing that knows them and this must not grow a second
 * opinion.
 *
 * No clock reaches in here. A row's "2h" label and its weight answer different
 * questions — when this last moved, versus whether an agent is in it now — and
 * the label is the one that reports time.
 */
export function workspaceRowEmphasis(input: {
  /** An agent is alive in this chat: a live PTY session, there to be spoken to. */
  resident: boolean
  /** The row you are in, in this window. */
  selected: boolean
  /** An agent on this row is mid-turn. */
  working: boolean
  /** Blocked on a prompt, or the unseen "finished while you were away" mark. */
  wantsYou: boolean
}): WorkspaceRowEmphasis {
  return input.resident || input.selected || input.working || input.wantsYou ? 'active' : 'quiet'
}
