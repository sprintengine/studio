import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ModuleChatRuntimeOption } from '../../../../shared/modules/conversation-service'
import { normalizeCliRuntimeOptions, type CliRuntimeOption } from './cliRuntimeCatalog'

// A module hands the picker what `RendererHost.listChatRuntimes()` returns;
// the app hands it catalog rows. Both have to arrive as catalog rows.

const claude: ModuleChatRuntimeOption = {
  id: 'claude',
  label: 'Claude Code',
  available: true,
  models: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
  lastSelected: true,
}

test('a chat runtime becomes a catalog row whose models are a closed model catalog', () => {
  assert.deepEqual(normalizeCliRuntimeOptions([claude]), [
    {
      value: 'claude',
      label: 'Claude Code',
      modelSelection: {
        options: [
          { id: 'opus', label: 'Opus' },
          { id: 'sonnet', label: 'Sonnet' },
        ],
        allowCustomId: false,
      },
    },
  ])
})

test('a chat runtime with no models offers no model choice', () => {
  const [row] = normalizeCliRuntimeOptions([{ ...claude, id: 'gemini', label: 'Gemini', models: [] }])
  assert.deepEqual(row, { value: 'gemini', label: 'Gemini' })
})

test('a runtime this machine lacks is left out unless it is the one already chosen', () => {
  const missing: ModuleChatRuntimeOption = { ...claude, id: 'codex', label: 'Codex', available: false }
  assert.deepEqual(
    normalizeCliRuntimeOptions([claude, missing], 'claude').map((row) => row.value),
    ['claude'],
  )
  assert.deepEqual(
    normalizeCliRuntimeOptions([claude, missing], 'codex').map((row) => row.value),
    ['claude', 'codex'],
  )
})

test('catalog rows pass through untouched, and the two shapes may be mixed', () => {
  const row: CliRuntimeOption = {
    value: 'opencode',
    label: 'OpenCode',
    modelSelection: { options: [{ id: 'any' }], allowCustomId: true },
    hostedVia: 'claude-code',
  }
  const normalized = normalizeCliRuntimeOptions([row, claude])
  assert.equal(normalized[0], row, 'a catalog row is the same object, not a copy')
  assert.equal(normalized[1]?.value, 'claude')
})
