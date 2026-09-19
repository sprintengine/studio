import assert from 'node:assert/strict'

import type { HostedCard } from '../../../shared/hosted-card-feed'
import type { AppNotification } from '../types/workspace'
import {
  AUTOMATIONS_NOTIFICATION_SOURCES,
  CORE_NOTIFICATION_SOURCE_ROWS,
  EXTENSIONS_NOTIFICATION_SOURCES,
  automationsRailBadge,
  extensionsRailBadge,
  extensionsRowBadge,
  extensionsRowOfNotification,
  homeRailBadge,
  unreadByExtensionsRow,
  unreadNotificationsFrom,
  unseenCardCount,
} from './railBadges'
import { test } from 'vitest'

test('railBadges', async () => {
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
  assert.equal(
    homeRailBadge({ needsInput: 0, failed: 0, finished: 0 }),
    null,
    'nothing wanting you is no badge, not a 0',
  )
  assert.deepEqual(homeRailBadge({ needsInput: 0, failed: 0, finished: 1 }), {
    count: 1,
    tone: 'good',
    label: '1 chat wants you',
  })
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
    note({ id: 'd', source: 'models', level: 'warning' }),
    note({ id: 'e', source: 'terminal', level: 'error' }),
    note({ id: 'f', source: 'cli' }),
  ]
  assert.deepEqual(
    unreadNotificationsFrom(list, AUTOMATIONS_NOTIFICATION_SOURCES).map((n) => n.id),
    ['a'],
    'read rows do not count',
  )
  assert.deepEqual(
    unreadNotificationsFrom(list, EXTENSIONS_NOTIFICATION_SOURCES).map((n) => n.id),
    ['c', 'd', 'f'],
  )
  assert.ok(
    !EXTENSIONS_NOTIFICATION_SOURCES.has('terminal') && !AUTOMATIONS_NOTIFICATION_SOURCES.has('terminal'),
    'a terminal crash badges no section',
  )

  // ── Automations ───────────────────────────────────────────────────────────────
  assert.equal(automationsRailBadge([]), null)
  assert.deepEqual(automationsRailBadge([note({ id: 'x' })]), {
    count: 1,
    tone: 'accent',
    label: '1 automation run to look at',
  })
  assert.equal(automationsRailBadge([note({ id: 'x' }), note({ id: 'y', level: 'warning' })])?.tone, 'warn')
  assert.equal(
    automationsRailBadge([note({ id: 'x', level: 'warning' }), note({ id: 'y', level: 'error' })])?.tone,
    'error',
    'the loudest level wins',
  )

  // ── Cards since last seen ─────────────────────────────────────────────────────
  // With artwork this build ships: a card it cannot draw is not on the page and
  // so is never counted (the home's own rule, which this counter delegates to).
  const card = (slug: string, publishedAt: string): HostedCard =>
    ({ slug, publishedAt, art: 'browser' }) as unknown as HostedCard
  const cards = [card('old', '2026-09-01'), card('new', '2026-09-06T12:00:00Z'), card('bad', 'not a date')]
  assert.equal(
    unseenCardCount(cards, undefined),
    0,
    'never looked is nothing new — the host stamps the first feed as seen',
  )
  assert.equal(
    unseenCardCount(cards, '2026-09-03T00:00:00Z'),
    1,
    'only cards published after the last look count; an unparseable date never does',
  )
  assert.equal(unseenCardCount(cards, 'garbage'), 0)
  assert.equal(
    unseenCardCount(
      [
        ...cards,
        { slug: 'unknown-art', publishedAt: '2026-09-07', art: 'nothing-this-build-has' } as unknown as HostedCard,
      ],
      '2026-09-03T00:00:00Z',
    ),
    1,
    'a card whose artwork this build cannot draw is not counted — the home would show no chip for it',
  )

  // ── News → drawer rows ────────────────────────────────────────────────────────
  // Owner, 2026-09-08: the notification goes on the row it came from. A source
  // decides the row unless the emitter said which.
  assert.equal(extensionsRowOfNotification(note({ source: 'cli' })), 'agent-clis')
  assert.equal(extensionsRowOfNotification(note({ source: 'models' })), 'agent-clis')
  assert.equal(
    extensionsRowOfNotification(note({ source: 'marketplace' })),
    'plugins',
    'the drift notice says "Open Plugins"',
  )
  assert.equal(
    extensionsRowOfNotification(note({ source: 'agents' })),
    null,
    'core knows no module source — a door-badge contribution supplies the source map',
  )
  assert.equal(
    extensionsRowOfNotification(note({ source: 'agents' }), { agents: 'skills' }),
    'skills',
    'an unnamed notice falls to the module’s own row via the contributed source map',
  )
  assert.equal(
    extensionsRowOfNotification(note({ source: 'agents', extensionsRow: 'design' })),
    'design',
    'an emitter that knows wins',
  )
  assert.equal(extensionsRowOfNotification(note({ source: 'marketplace', extensionsRow: 'skills' })), 'skills')
  assert.equal(
    extensionsRowOfNotification(note({ source: 'marketplace', extensionsRow: 'nonsense' })),
    'plugins',
    'an unknown row name falls back to the source rule',
  )
  assert.equal(extensionsRowOfNotification(note({ source: 'terminal' })), null, 'a terminal crash badges no row')
  assert.equal(
    extensionsRowOfNotification(note({ source: 'terminal', extensionsRow: 'design' })),
    'design',
    'any source may name a row',
  )
  assert.equal(CORE_NOTIFICATION_SOURCE_ROWS.agents, undefined, 'the core map has no module rows')

  const MODULE_SOURCE_ROWS = { agents: 'skills' as const }

  const byRow = unreadByExtensionsRow(
    [
      ...list,
      note({ id: 'g', source: 'cli', read: true }),
      note({ id: 'h', source: 'agents', extensionsRow: 'design' }),
      note({ id: 'i', source: 'agents' }),
    ],
    MODULE_SOURCE_ROWS,
  )
  assert.deepEqual(
    Object.fromEntries(Object.entries(byRow).map(([row, rows]) => [row, rows.map((n) => n.id)])),
    { design: ['h'], plugins: ['c'], skills: ['i'], 'agent-clis': ['d', 'f'] },
    'every row is present; read rows and rows from other sources do not count',
  )

  // ── One row's count ───────────────────────────────────────────────────────────
  assert.equal(extensionsRowBadge({ label: 'Plugins', unread: [] }), null, 'nothing is no badge, not a 0')
  assert.deepEqual(extensionsRowBadge({ label: 'Plugins', unread: [note({ id: 'c', source: 'marketplace' })] }), {
    count: 1,
    tone: 'accent',
    label: 'Plugins: 1 new',
    detail: '1 new',
  })
  assert.deepEqual(
    extensionsRowBadge({ label: 'Skills', unread: [note({ id: 'd', source: 'marketplace' })], waiting: 2 }),
    { count: 3, tone: 'warn', label: 'Skills: 2 waiting on you, 1 new', detail: '2 waiting on you, 1 new' },
    'something waiting on you is gold and the label keeps the two apart',
  )
  assert.deepEqual(
    extensionsRowBadge({ label: 'Design', unread: [], arrived: 4 }),
    { count: 4, tone: 'accent', label: 'Design: 4 new', detail: '4 new' },
    'entries arrived since the last look are news',
  )
  assert.equal(
    extensionsRowBadge({ label: 'Agent CLIs', unread: [note({ id: 'e', level: 'error', source: 'cli' })], waiting: 1 })
      ?.tone,
    'error',
    'a failure still outranks a wait',
  )
  assert.equal(
    extensionsRowBadge({ label: 'Agent CLIs', unread: [note({ id: 'w', level: 'warning', source: 'models' })] })?.tone,
    'warn',
  )

  // ── Extensions: the sum of its rows ──────────────────────────────────────────
  assert.equal(extensionsRailBadge({ rows: {}, unseenCards: 0 }), null)
  assert.deepEqual(
    extensionsRailBadge({
      rows: { plugins: { count: 1, tone: 'accent', label: 'Plugins: 1 new' }, skills: null },
      unseenCards: 2,
    }),
    { count: 3, tone: 'accent', label: '3 new in Extensions' },
    'the square counts what its rows count, plus the cards the home will mark',
  )
  assert.equal(
    extensionsRailBadge({
      rows: { skills: { count: 1, tone: 'warn', label: 'Skills: 1 waiting on you' } },
      unseenCards: 0,
    })?.tone,
    'warn',
    'a row waiting on you is gold',
  )
  assert.equal(
    extensionsRailBadge({
      rows: {
        skills: { count: 1, tone: 'warn', label: 'Skills: 1 waiting on you' },
        'agent-clis': { count: 1, tone: 'error', label: 'Agent CLIs: 1 new' },
      },
      unseenCards: 0,
    })?.tone,
    'error',
    'the loudest row decides the square',
  )
  assert.deepEqual(extensionsRailBadge({ rows: {}, unseenCards: 1 }), {
    count: 1,
    tone: 'accent',
    label: '1 new in Extensions',
  })

  console.log('railBadges.test.ts: ok')
})
