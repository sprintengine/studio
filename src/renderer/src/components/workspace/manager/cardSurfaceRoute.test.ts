import assert from 'node:assert/strict'
import { test } from 'vitest'

import { cardSurfaceRoute } from './cardSurfaceRoute'

test('a card that opens the retired Agent CLIs view lands on Settings ▸ Agents', () => {
  // Published cards still name `agent-clis` (the feed's view names are a
  // permanent contract); the list that view showed is in Settings now.
  assert.deepEqual(cardSurfaceRoute('agent-clis'), { kind: 'settings-agents' })
})

test('the Extensions views and the home land where they always did', () => {
  assert.deepEqual(cardSurfaceRoute('home'), { kind: 'extensions-home' })
  assert.deepEqual(cardSurfaceRoute('plugins'), { kind: 'extensions', view: 'plugins' })
  assert.deepEqual(cardSurfaceRoute('skills'), { kind: 'extensions', view: 'skills' })
})
