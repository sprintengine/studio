import assert from 'node:assert/strict'
import { test } from 'vitest'

import { chatPermissionRefusals } from './AgentChatView'

test('a chat offers every preset its CLI and machine can run', () => {
  assert.equal(chatPermissionRefusals({ cli: 'claude-code', allowed: undefined, permissionModes: true }), undefined)
})

test('Cursor cannot be held to Manual, and the row says why', () => {
  assert.deepEqual(
    chatPermissionRefusals({ cli: 'cursor', allowed: ['none', 'auto', 'bypass'], permissionModes: true }),
    {
      manual: 'Cursor edits files without asking, so it cannot ask before every change.',
    },
  )
})

test('a preset the provider does not list is dimmed', () => {
  assert.deepEqual(chatPermissionRefusals({ cli: 'grok', allowed: ['none', 'bypass'], permissionModes: true }), {
    manual: 'This agent cannot run with this preset.',
    auto: 'This agent cannot run with this preset.',
  })
})

test('a paired machine that reads Manual and Auto as No flag is not offered either', () => {
  assert.deepEqual(
    chatPermissionRefusals({ cli: 'codex', allowed: undefined, permissionModes: false, machineName: 'mac-mini' }),
    {
      manual: 'mac-mini needs a newer Studio for this.',
      auto: 'mac-mini needs a newer Studio for this.',
    },
  )
})
