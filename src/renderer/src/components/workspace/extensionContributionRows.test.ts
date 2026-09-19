import assert from 'node:assert/strict'
import React from 'react'

import type { RegisteredGlobalSurface } from '../../modules/renderer-host'
import { extensionContributionRows } from './extensionContributionRows'

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
    surface('automations', 'Automations'),
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
  'installed doors follow the fixed product rows, while rail, fixed, and nameless surfaces stay out',
)
assert.deepEqual(
  rows.map((row) => row.rowId),
  [null, null, null],
  'contributed rows do not claim fixed notification keys',
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
