import type { Activity } from './rowStyle'

// A folded project hides its rows, and with them the gold of a chat that is
// waiting on the person. Its header says how many there are, in words — "2
// waiting" — the same chats "Go to next chat that needs you" visits: blocked
// on a question or an approval, or stopped by a failed turn. Unfolded, the
// rows say it themselves and the header says nothing.

export function waitingChatCount(activities: Iterable<Activity | undefined>): number {
  let count = 0
  for (const activity of activities) if (activity === 'needs-input' || activity === 'failed') count += 1
  return count
}

/** The header's words for `count` waiting chats, or null when none is. */
export function waitingLabel(count: number): string | null {
  return count > 0 ? `${count} waiting` : null
}
