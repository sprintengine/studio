import assert from 'node:assert/strict'
import React from 'react'

import type { RegisteredGlobalSurface, RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { extensionContributionRows } from './extensionContributionRows'
import { test } from 'vitest'

test('extensionContributionRows', async () => {
  const Icon = ({ className }: { className?: string }) => React.createElement('svg', { className })
  const surface = (id: string, label?: string): RegisteredGlobalSurface => ({
    id,
    moduleId: id,
    ...(label ? { label, Icon } : {}),
    Component: () => null,
  })

  const events: string[] = []
  const rows = extensionContributionRows({
    surfaces: [
      surface('design', 'Design'),
      { ...surface('acme.compass', 'Compass'), onOpen: () => events.push('prepare-compass') },
      {
        ...surface('acme.reports', 'Reports'),
        views: [
          { id: 'recent', label: 'Recent reports', Icon, open: () => events.push('prepare-recent') },
          { id: 'saved', label: 'Saved reports', Icon, open: () => events.push('prepare-saved') },
        ],
      },
      surface('acme.nameless'),
    ],
    activeGlobalSurface: 'acme.reports',
    activeView: 'saved',
    enterExtensions: () => events.push('enter-extensions'),
    openGlobalSurface: (id) => events.push(`open:${id}`),
  })

  assert.deepEqual(
    rows.map((row) => row.key),
    [
      'contribution-surface:acme.compass',
      'contribution-view:acme.reports:recent',
      'contribution-view:acme.reports:saved',
    ],
    'installed doors follow the fixed product rows, while fixed and nameless surfaces stay out',
  )
  assert.deepEqual(
    rows.map((row) => row.rowId),
    ['acme.compass', 'acme.reports', null],
    'an installed door is keyed by its surface id, worn once: on its only row, or the first of its views',
  )
  assert.deepEqual(
    rows.map((row) => row.active),
    [false, false, true],
    'only the open view reads selected',
  )

  rows[0]?.open()
  assert.deepEqual(
    events,
    ['prepare-compass', 'enter-extensions', 'open:acme.compass'],
    'a contributed door prepares itself, keeps the Extensions drawer in place, then opens',
  )
  events.length = 0
  rows[1]?.open()
  assert.deepEqual(
    events,
    ['prepare-recent', 'enter-extensions', 'open:acme.reports'],
    'a contributed view latches its destination before its surface opens',
  )

  console.log('extensionContributionRows.test.ts: ok')
})

test('a nav entry under its own surface id IS that door row, and nothing else is', () => {
  const Icon = ({ className }: { className?: string }) => React.createElement('svg', { className })
  const NavRow = () => null
  const OtherRow = () => null
  const events: string[] = []
  const surfaces: RegisteredGlobalSurface[] = [
    // No label or glyph: only its own nav entry can draw it.
    { id: 'acme.board', moduleId: 'acme.board', Component: () => null, onOpen: () => events.push('board-onOpen') },
    {
      id: 'acme.insights',
      moduleId: 'acme.insights',
      label: 'Insights',
      Icon,
      views: [
        { id: 'usage', label: 'Usage', Icon, open: () => undefined },
        { id: 'standup', label: 'Standup', Icon, open: () => undefined },
      ],
      Component: () => null,
    },
    { id: 'acme.radar', moduleId: 'acme.radar', label: 'Radar', Icon, Component: () => null },
    { id: 'design', moduleId: 'design', label: 'Design', Icon, Component: () => null },
  ]
  const navEntries: RegisteredSidebarNavEntry[] = [
    { id: 'acme.board', moduleId: 'acme.board', order: 0, Component: NavRow },
    // A nav entry naming its door replaces the view rows with the one row it draws.
    { id: 'acme.insights', moduleId: 'acme.insights', order: 0, Component: NavRow },
    // Another module's entry under this door's id is not this door's row.
    { id: 'acme.radar', moduleId: 'acme.squatter', order: 0, Component: OtherRow },
    // An entry that names no surface is drawn nowhere.
    { id: 'acme.board-nav', moduleId: 'acme.board', order: 0, Component: OtherRow },
    // A fixed product row is never replaced.
    { id: 'design', moduleId: 'design', order: 0, Component: OtherRow },
  ]
  const rows = extensionContributionRows({
    surfaces,
    navEntries,
    activeGlobalSurface: 'acme.board',
    activeView: null,
    enterExtensions: () => events.push('enter-extensions'),
    openGlobalSurface: (id) => events.push(`open:${id}`),
  })
  assert.deepEqual(
    rows.map((row) => [row.key, row.rowId, row.navComponent === NavRow]),
    [
      ['contribution-nav:acme.board', 'acme.board', true],
      ['contribution-nav:acme.insights', 'acme.insights', true],
      ['contribution-surface:acme.radar', 'acme.radar', false],
    ],
  )
  assert.equal(rows[0]?.active, true, 'the nav row reads selected while its door is open')
  rows[0]?.open()
  assert.deepEqual(events, ['board-onOpen', 'enter-extensions', 'open:acme.board'])
})
