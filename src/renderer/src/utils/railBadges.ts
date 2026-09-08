// The app rail's badges (owner ruling 2026-09-07): the unread activity count on the
// rail, as the kit's corner counter. Each square carries the number of things
// in its area that the person has not seen or that are waiting on them, so a
// person reading the Extensions home still knows a chat finished, and a person
// in a chat knows an overnight automation failed. Pure derivations over data
// the stores already hold — no second source of truth about what an agent is
// doing (that is `getWorkspaceActivity`), what finished while you were away
// (the sidebar's unseen-done mark), or what a notification is (the bell's own
// list). The hook that feeds these is `useRailBadges`.
//
// Counts, not toasts. A glass toast for every chat that finished would be over
// the top; the count says "come back here" without interrupting what the person
// is doing, and the section's own surface does the telling once they arrive.

import type { RailBadge } from '../components/workspace/AppRail'
import type { HostedCard } from '../../../shared/hosted-card-feed'
import type { AppNotification, DiagnosticSource } from '../types/workspace'

// Which bell notifications belong under which rail square. A source that is
// not in either set (a git failure, a terminal crash, an auth problem) is a
// workspace-level or window-level fact and badges no section.
export const AUTOMATIONS_NOTIFICATION_SOURCES: ReadonlySet<DiagnosticSource> = new Set<DiagnosticSource>([
  'automations',
])
// Plugins and skills (marketplace), Sprints and Workflows (sprintengine), and
// the Agent CLIs row's two feeds (cli updates, hosted models).
export const EXTENSIONS_NOTIFICATION_SOURCES: ReadonlySet<DiagnosticSource> = new Set<DiagnosticSource>([
  'marketplace',
  'sprintengine',
  'cli',
  'models',
])

export function unreadNotificationsFrom(
  notifications: readonly AppNotification[],
  sources: ReadonlySet<DiagnosticSource>,
): AppNotification[] {
  return notifications.filter((notification) => !notification.read && sources.has(notification.source))
}

// The loudest level decides the badge's tone: a failure is red, something
// blocked or waiting is gold, and plain news is the accent.
function notificationsTone(unread: readonly AppNotification[]): RailBadge['tone'] {
  if (unread.some((notification) => notification.level === 'error')) return 'error'
  if (unread.some((notification) => notification.level === 'warning')) return 'warn'
  return 'accent'
}

/**
 * How many hosted cards were published after the Extensions home was last
 * looked at. Never seen (a fresh install, before the first feed lands) is
 * nothing new: the host stamps the first ready feed as seen, so the badge only
 * ever counts cards that arrived while this person was using the app.
 */
export function unseenCardCount(cards: readonly HostedCard[], seenAt: string | undefined): number {
  if (!seenAt) return 0
  const seenMs = Date.parse(seenAt)
  if (Number.isNaN(seenMs)) return 0
  let count = 0
  for (const card of cards) {
    const publishedMs = Date.parse(card.publishedAt)
    if (!Number.isNaN(publishedMs) && publishedMs > seenMs) count += 1
  }
  return count
}

/**
 * Home: the chats that want you — blocked on a prompt, crashed, or finished
 * while you were away — other than the one on screen, which you are looking
 * at. Gold when any is waiting on a prompt (the row's own gold outranks the
 * green the same way), red when one crashed, green when the news is only that
 * something finished.
 */
export function homeRailBadge(input: { needsInput: number; failed: number; finished: number }): RailBadge | null {
  const count = input.needsInput + input.failed + input.finished
  if (count <= 0) return null
  const tone = input.needsInput > 0 ? 'warn' : input.failed > 0 ? 'error' : 'good'
  return { count, tone, label: count === 1 ? '1 chat wants you' : `${count} chats want you` }
}

/** Automations: the scheduled runs that ended while the door was closed. */
export function automationsRailBadge(unread: readonly AppNotification[]): RailBadge | null {
  const count = unread.length
  if (count <= 0) return null
  return {
    count,
    tone: notificationsTone(unread),
    label: count === 1 ? '1 automation run to look at' : `${count} automation runs to look at`,
  }
}

/**
 * Extensions: unread news from anything under the glyph — a plugin source that
 * moved, a CLI with an update, a sprint that finished — plus the cards
 * published since the home was last open, plus every sprint waiting on an
 * answer. The sprints are live rather than read-once: a run blocked on you
 * stays counted until you answer it, exactly as a chat blocked on a prompt
 * does on Home.
 */
export function extensionsRailBadge(input: {
  unread: readonly AppNotification[]
  unseenCards: number
  sprintsWaiting: number
}): RailBadge | null {
  const count = input.unread.length + input.unseenCards + input.sprintsWaiting
  if (count <= 0) return null
  const unreadTone = input.unread.length > 0 ? notificationsTone(input.unread) : 'accent'
  const tone = unreadTone === 'error' ? 'error' : input.sprintsWaiting > 0 || unreadTone === 'warn' ? 'warn' : 'accent'
  return { count, tone, label: count === 1 ? '1 new in Extensions' : `${count} new in Extensions` }
}
