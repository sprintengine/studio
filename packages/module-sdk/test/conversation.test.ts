import assert from 'node:assert/strict'
import { test } from 'vitest'

import { getConversationService } from '../src/conversation.js'
import type { MainHost } from '../src/index.js'

// A host's raw registry as `conversation.module-service` serves it, recording
// every call with the module id the helper closed over.
function hostWith(registry: Record<string, (...args: unknown[]) => unknown>): MainHost {
  return {
    moduleId: 'acme',
    requireService: () => registry,
  } as unknown as MainHost
}

test('the helper forwards the new controls with the module’s id', async () => {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return { ok: true }
    }
  const chats = getConversationService(
    hostWith({ setPermissionPreset: record('setPermissionPreset'), setModel: record('setModel') }),
  )
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  await chats.setPermissionPreset(ref, 'auto')
  await chats.setModel(ref, 'default')
  assert.deepEqual(calls, [
    ['setPermissionPreset', 'acme', ref, 'auto'],
    ['setModel', 'acme', ref, 'default'],
  ])
})

test('a host from before conversation-controls answers a refusal, not a TypeError', async () => {
  const chats = getConversationService(hostWith({}))
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  for (const answer of [await chats.setPermissionPreset(ref, 'manual'), await chats.setModel(ref, 'default')]) {
    assert.equal(answer.ok, false)
    if (answer.ok) continue
    assert.equal(answer.code, 'runtime_refused')
    assert.match(answer.message, /conversation-controls/)
  }
})
