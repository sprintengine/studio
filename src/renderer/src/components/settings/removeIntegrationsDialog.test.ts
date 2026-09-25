import assert from 'node:assert/strict'
import { test } from 'vitest'

import { groupRemovalItems, removalSummaryLine } from './RemoveIntegrationsDialog'

test('the confirmation lists groups in a fixed order, leaving out empty ones', () => {
  const grouped = groupRemovalItems([
    { group: 'launcher' as const, id: 'l' },
    { group: 'repositories' as const, id: 'a' },
    { group: 'repositories' as const, id: 'b' },
    { group: 'tailnet' as const, id: 't' },
  ])
  assert.deepEqual(
    grouped.map(({ group, items }) => [group, items.length]),
    [
      ['repositories', 2],
      ['tailnet', 1],
      ['launcher', 1],
    ],
  )
})

test('the result reads as three counts', () => {
  assert.equal(removalSummaryLine({ removed: 3, skipped: 1, failed: 0 }), '3 removed · 1 skipped · 0 failed')
})
