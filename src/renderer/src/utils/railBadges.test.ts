import assert from 'node:assert/strict'

import type { HostedCard } from '../../../shared/hosted-card-feed'
import type { AppNotification } from '../types/workspace'
import {
  AUTOMATIONS_NOTIFICATION_SOURCES,
  EXTENSIONS_NOTIFICATION_SOURCES,
  automationsRailBadge,
  extensionsRailBadge,
  homeRailBadge,
  unreadNotificationsFrom,
  unseenCardCount,
} from './railBadges'

const note = (over: Partial<AppNotification>): AppNotification => ({
  id: over.id ?? 'n',
  timestamp: '2026-09-07T10:00:00.000Z',
  level: 'info',
  source: 'automations',
  title: 't',
  message: 'm',
  read: false,
  ...over,
})

// ── Home ──────────────────────────────────────────────────────────────────────
assert.equal(homeRailBadge({ needsInput: 0, failed: 0, finished: 0 }), null, 'nothing wanting you is no badge, not a 0')
assert.deepEqual(homeRailBadge({ needsInput: 0, failed: 0, finished: 1 }), { count: 1, tone: 'good', label: '1 chat wants you' })
assert.deepEqual(
  homeRailBadge({ needsInput: 1, failed: 1, finished: 2 }),
  { count: 4, tone: 'warn', label: '4 chats want you' },
  'a prompt waiting outranks a crash and a finish, as the row’s gold does',
)
assert.equal(homeRailBadge({ needsInput: 0, failed: 1, finished: 3 })?.tone, 'error', 'a crash outranks a finish')

// ── Sources → squares ─────────────────────────────────────────────────────────
const list = [
  note({ id: 'a', source: 'automations', level: 'error' }),
  note({ id: 'b', source: 'automations', read: true }),
  note({ id: 'c', source: 'marketplace' }),
  note({ id: 'd', source: 'sprintengine', level: 'warning' }),
  note({ id: 'e', source: 'terminal', level: 'error' }),
  note({ id: 'f', source: 'cli' }),
]
assert.deepEqual(unreadNotificationsFrom(list, AUTOMATIONS_NOTIFICATION_SOURCES).map((n) => n.id), ['a'], 'read rows do not count')
assert.deepEqual(unreadNotificationsFrom(list, EXTENSIONS_NOTIFICATION_SOURCES).map((n) => n.id), ['c', 'd', 'f'])
assert.ok(!EXTENSIONS_NOTIFICATION_SOURCES.has('terminal') && !AUTOMATIONS_NOTIFICATION_SOURCES.has('terminal'), 'a terminal crash badges no section')

// ── Automations ───────────────────────────────────────────────────────────────
assert.equal(automationsRailBadge([]), null)
assert.deepEqual(automationsRailBadge([note({ id: 'x' })]), { count: 1, tone: 'accent', label: '1 automation run to look at' })
assert.equal(automationsRailBadge([note({ id: 'x' }), note({ id: 'y', level: 'warning' })])?.tone, 'warn')
assert.equal(automationsRailBadge([note({ id: 'x', level: 'warning' }), note({ id: 'y', level: 'error' })])?.tone, 'error', 'the loudest level wins')

// ── Cards since last seen ─────────────────────────────────────────────────────
const card = (slug: string, publishedAt: string): HostedCard => ({ slug, publishedAt } as unknown as HostedCard)
const cards = [card('old', '2026-09-01'), card('new', '2026-09-06T12:00:00Z'), card('bad', 'not a date')]
assert.equal(unseenCardCount(cards, undefined), 0, 'never looked is nothing new — the host stamps the first feed as seen')
assert.equal(unseenCardCount(cards, '2026-09-03T00:00:00Z'), 1, 'only cards published after the last look count; an unparseable date never does')
assert.equal(unseenCardCount(cards, 'garbage'), 0)

// ── Extensions ────────────────────────────────────────────────────────────────
assert.equal(extensionsRailBadge({ unread: [], unseenCards: 0, sprintsWaiting: 0 }), null)
assert.deepEqual(
  extensionsRailBadge({ unread: [note({ id: 'c', source: 'marketplace' })], unseenCards: 2, sprintsWaiting: 0 }),
  { count: 3, tone: 'accent', label: '3 new in Extensions' },
)
assert.equal(extensionsRailBadge({ unread: [], unseenCards: 0, sprintsWaiting: 1 })?.tone, 'warn', 'a sprint waiting on you is gold')
assert.equal(
  extensionsRailBadge({ unread: [note({ id: 'e', level: 'error', source: 'cli' })], unseenCards: 0, sprintsWaiting: 1 })?.tone,
  'error',
  'a failure still outranks a wait',
)

console.log('railBadges.test.ts: ok')
