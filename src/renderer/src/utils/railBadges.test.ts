import assert from 'node:assert/strict'

import type { HostedCard } from '../../../shared/hosted-card-feed'
import type { AppNotification } from '../types/workspace'
import {
  CORE_NOTIFICATION_SOURCE_ROWS,
  EXTENSIONS_NOTIFICATION_SOURCES,
  extensionsRailBadge,
  extensionsRowBadge,
  extensionsRowOfNotification,
  homeRailBadge,
  unreadByExtensionsRow,
  unseenCardCount,
} from './railBadges'
import { test } from 'vitest'

test('railBadges', async () => {
  const note = (over: Partial<AppNotification>): AppNotification => ({
    id: over.id ?? 'n',
    timestamp: '2026-09-07T10:00:00.000Z',
    level: 'info',
    source: 'marketplace',
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
    note({ id: 'b', source: 'marketplace', read: true }),
    note({ id: 'c', source: 'marketplace' }),
    note({ id: 'd', source: 'models', level: 'warning' }),
    note({ id: 'e', source: 'terminal', level: 'error' }),
    note({ id: 'f', source: 'cli' }),
  ]
  assert.deepEqual([...EXTENSIONS_NOTIFICATION_SOURCES], ['marketplace'])
  assert.ok(
    !EXTENSIONS_NOTIFICATION_SOURCES.has('terminal') && !EXTENSIONS_NOTIFICATION_SOURCES.has('cli'),
    'a terminal crash badges no section, and a CLI update is Settings ▸ Agents news now',
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
  // Agent CLIs left the drawer (owner ruling 2026-09-25): a CLI update and model
  // news belong to no row, so they badge no Extensions square either.
  assert.equal(extensionsRowOfNotification(note({ source: 'cli' })), null)
  assert.equal(extensionsRowOfNotification(note({ source: 'models' })), null)
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
    { design: ['h'], plugins: ['c'], skills: ['i'] },
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
    extensionsRowBadge({
      label: 'Plugins',
      unread: [note({ id: 'e', level: 'error', source: 'marketplace' })],
      waiting: 1,
    })?.tone,
    'error',
    'a failure still outranks a wait',
  )
  assert.equal(
    extensionsRowBadge({ label: 'Plugins', unread: [note({ id: 'w', level: 'warning', source: 'marketplace' })] })
      ?.tone,
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
        plugins: { count: 1, tone: 'error', label: 'Plugins: 1 new' },
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

test("a module's notify rows badge only that module's own door rows", () => {
  const moduleRow = (over: Partial<AppNotification>): AppNotification => ({
    id: over.id ?? 'm',
    timestamp: '2026-10-09T10:00:00.000Z',
    level: 'info',
    source: 'module',
    title: 't',
    message: '',
    read: false,
    sourceModule: { id: 'acme.radar', name: 'PR Radar' },
    ...over,
  })
  const doors = new Map([
    ['acme.radar', 'acme.radar'],
    ['acme.insights', 'acme.insights'],
    ['acme.insights-usage', 'acme.insights'],
  ])
  const moduleRows = { doors, fallbackByModule: {} }

  assert.equal(
    extensionsRowOfNotification(moduleRow({ extensionsRow: 'acme.radar' }), undefined, moduleRows),
    'acme.radar',
  )
  assert.equal(
    extensionsRowOfNotification(moduleRow({ extensionsRow: 'acme.insights' }), undefined, moduleRows),
    'acme.radar',
    "a target on another module's door falls back to the module's own one door",
  )
  assert.equal(
    extensionsRowOfNotification(moduleRow({}), undefined, moduleRows),
    'acme.radar',
    'one door takes its news',
  )
  const insights = moduleRow({ sourceModule: { id: 'acme.insights', name: 'Insights' } })
  assert.equal(extensionsRowOfNotification(insights, undefined, moduleRows), null, 'two doors and no claim: no row')
  assert.equal(
    extensionsRowOfNotification(insights, undefined, { doors, fallbackByModule: { 'acme.insights': 'acme.insights' } }),
    'acme.insights',
    'the badge claimed the untargeted news',
  )
  assert.equal(
    extensionsRowOfNotification(moduleRow({ extensionsRow: 'design' })),
    null,
    'a module row never lands on a fixed row',
  )
  assert.equal(
    extensionsRowOfNotification(note({ source: 'marketplace', extensionsRow: 'acme.radar' }), undefined, moduleRows),
    'plugins',
    "a core row cannot be pointed at a module's door",
  )

  const byRow = unreadByExtensionsRow(
    [moduleRow({ id: 'a', extensionsRow: 'acme.radar' }), moduleRow({ id: 'b', read: true }), note({ id: 'c' })],
    undefined,
    moduleRows,
  )
  assert.deepEqual(Object.fromEntries(Object.entries(byRow).map(([row, rows]) => [row, rows.map((n) => n.id)])), {
    design: [],
    plugins: ['c'],
    skills: [],
    'acme.radar': ['a'],
    'acme.insights': [],
    'acme.insights-usage': [],
  })
})

function note(over: Partial<AppNotification>): AppNotification {
  return {
    id: over.id ?? 'n',
    timestamp: '2026-09-07T10:00:00.000Z',
    level: 'info',
    source: 'marketplace',
    title: 't',
    message: 'm',
    read: false,
    ...over,
  }
}
