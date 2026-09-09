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
import {
  EXTENSIONS_DRAWER_ROW_IDS,
  isExtensionsDrawerRowId,
  type ExtensionsDrawerRowId,
} from '../components/workspace/extensionsDrawer'
import { newHomeCardSlugs } from '../components/extensions/homeCards'
import type { HostedCard } from '../../../shared/hosted-card-feed'
import type { AppNotification, DiagnosticSource } from '../types/workspace'

// Which bell notifications belong under which rail square. A source that is
// not in either set (a git failure, a terminal crash, an auth problem) is a
// workspace-level or window-level fact and badges no section.
export const AUTOMATIONS_NOTIFICATION_SOURCES: ReadonlySet<DiagnosticSource> = new Set<DiagnosticSource>([
  'automations',
])
// Plugins and skills (marketplace), Sprints and Workflows (sprintengine), and
// the Agent CLIs row's two feeds (cli updates, hosted models). Which ROW of the
// drawer each belongs to is `extensionsRowOfNotification`.
export const EXTENSIONS_NOTIFICATION_SOURCES: ReadonlySet<DiagnosticSource> = new Set<DiagnosticSource>([
  'marketplace',
  'sprintengine',
  'cli',
  'models',
])

/**
 * The drawer row a piece of news belongs to — the row that wears its count and
 * the row whose opening reads it (owner, 2026-09-08: "put the notification on
 * whatever row it came from"). An emitter that knows says so on the
 * notification; otherwise the source decides:
 *
 *   cli, models   → Agent CLIs. A CLI update and a model feed change are both
 *                   about the runtimes that row lists.
 *   marketplace   → Plugins. The one notice this source carries is the source
 *                   drift check, whose own copy says "Open Plugins and press
 *                   Sync" — Sync there takes the changes for Skills too, since
 *                   the two rows read the same sources.
 *   sprintengine  → Sprints. A run notice that does not name its door falls to
 *                   Sprints, exactly as an unclassifiable run does in the run
 *                   index (`runDoors.ts`); an emitter that knows it is about a
 *                   workflow sets `extensionsRow: 'workflows'`.
 *
 * Null for everything else: a git failure or a terminal crash is a workspace
 * fact and badges no row.
 */
export function extensionsRowOfNotification(
  notification: Pick<AppNotification, 'source' | 'extensionsRow'>,
): ExtensionsDrawerRowId | null {
  if (isExtensionsDrawerRowId(notification.extensionsRow)) return notification.extensionsRow
  switch (notification.source) {
    case 'cli':
    case 'models':
      return 'agent-clis'
    case 'marketplace':
      return 'plugins'
    case 'sprintengine':
      return 'sprints'
    default:
      return null
  }
}

/** The unread news under each drawer row. Every row is present, empty or not. */
export function unreadByExtensionsRow(
  notifications: readonly AppNotification[],
): Readonly<Record<ExtensionsDrawerRowId, AppNotification[]>> {
  const byRow = {} as Record<ExtensionsDrawerRowId, AppNotification[]>
  for (const row of EXTENSIONS_DRAWER_ROW_IDS) byRow[row] = []
  for (const notification of notifications) {
    if (notification.read) continue
    const row = extensionsRowOfNotification(notification)
    if (row) byRow[row].push(notification)
  }
  return byRow
}

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

// Danger, then warn, then the rest — the order principles.md gives the rail.
const TONE_RANK: Readonly<Record<RailBadge['tone'], number>> = { error: 3, warn: 2, good: 1, accent: 1, neutral: 0 }
function loudestTone(tones: readonly RailBadge['tone'][]): RailBadge['tone'] {
  let loudest: RailBadge['tone'] = 'accent'
  for (const tone of tones) if (TONE_RANK[tone] > TONE_RANK[loudest]) loudest = tone
  return loudest
}

/**
 * How many hosted cards were published after the Extensions home was last
 * looked at — the size of the set the home marks with the New chip, so the
 * square's number and the page's chips are one rule (`newHomeCardSlugs`).
 * Never seen (a fresh install, before the first feed lands) is nothing new:
 * the host stamps the first ready feed as seen, so the badge only ever counts
 * cards that arrived while this person was using the app.
 */
export function unseenCardCount(cards: readonly HostedCard[], seenAt: string | undefined): number {
  return newHomeCardSlugs(cards, seenAt).size
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
 * One drawer row's count: its unread news, plus what is live there — runs
 * waiting on an answer for a run door, entries arrived since the last look for
 * Design. The news is read-once and clears when the row opens; the live part
 * stays until it is answered or looked at, exactly as a chat blocked on a
 * prompt does on Home. Gold when something is waiting or a warning is unread,
 * red when a failure is, the accent for plain news.
 *
 * The label names the row because the badge is its own live region: a screen
 * reader hears "Sprints: 1 waiting on you, 2 new", not a bare "3".
 */
export function extensionsRowBadge(input: {
  /** The row's name, as its module declares it. */
  label: string
  unread: readonly AppNotification[]
  /** Runs blocked on the person, for a run door. */
  waiting?: number
  /** Entries arrived since the bundle was last shown, for Design. */
  arrived?: number
}): RailBadge | null {
  const waiting = input.waiting ?? 0
  const arrived = input.arrived ?? 0
  const news = input.unread.length + arrived
  const count = waiting + news
  if (count <= 0) return null
  const tone = loudestTone([
    input.unread.length > 0 ? notificationsTone(input.unread) : 'accent',
    waiting > 0 ? 'warn' : 'accent',
  ])
  const parts: string[] = []
  if (waiting > 0) parts.push(`${waiting} waiting on you`)
  if (news > 0) parts.push(`${news} new`)
  const detail = parts.join(', ')
  return { count, tone, label: `${input.label}: ${detail}`, detail }
}

/**
 * Extensions: the sum of its rows, plus the cards published since the home was
 * last open. The square says how much is under the glyph; each row of the
 * drawer says where — except the cards, which no row wears: the square's own
 * click opens the home that shows them, so the square is their row. Opening the section reads nothing — a row reads its own
 * count when it opens, and the home reads the cards — so the square keeps
 * counting while the drawer is on screen, the way a workspace icon does above
 * its unread channels.
 */
export function extensionsRailBadge(input: {
  rows: Readonly<Partial<Record<ExtensionsDrawerRowId, RailBadge | null>>>
  unseenCards: number
}): RailBadge | null {
  const rows = Object.values(input.rows).filter((row): row is RailBadge => Boolean(row))
  const count = rows.reduce((sum, row) => sum + row.count, 0) + input.unseenCards
  if (count <= 0) return null
  const tone = loudestTone(rows.map((row) => row.tone))
  return { count, tone, label: count === 1 ? '1 new in Extensions' : `${count} new in Extensions` }
}
