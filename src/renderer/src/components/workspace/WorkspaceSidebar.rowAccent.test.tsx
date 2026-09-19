import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import { rowAccent } from './WorkspaceSidebar'
import { test } from 'vitest'

test('WorkspaceSidebar.rowAccent', async () => {
  function ws(mode: Workspace['mode'], highlight?: Workspace['highlight']): Workspace {
    return { id: 'w', name: 'w', mode, folderPath: null, highlight } as Workspace
  }

  // Selection is a neutral fill: no identity border for an accent to live on, and
  // — since the row lost its icon on 2026-09-02 — nothing per-mode left to tint.
  // Every mode reads the same, which is the thing this suite now pins.
  const host = rowAccent(ws('automations-host'))
  assert.deepEqual(host, rowAccent(ws('standard')), 'a background host row and a chat row wear the same accent')
  assert.deepEqual(
    host,
    rowAccent(ws('future-plugin-mode' as Workspace['mode'])),
    'an unknown mode id resolves without throwing',
  )
  assert.ok(host.bg.includes('--bg-selected'), 'the selected row wears the canonical selection fill')
  assert.ok(!Object.values(host).some((value) => value.includes('border-l-')), 'no row accent field carries a left bar')

  // A highlight color still overrides the row accent: user-set identity, not
  // selection, so it replaces both the fill and the ink.
  const highlighted = rowAccent(ws('standard', { color: 'blue', starred: false }))
  assert.ok(!highlighted.bg.includes('--bg-selected'), 'a highlighted row swaps the neutral fill for its hue')
  assert.notDeepEqual(highlighted, host, 'the highlight override still reaches the accent')

  console.log('workspace sidebar row accent tests passed')
})
