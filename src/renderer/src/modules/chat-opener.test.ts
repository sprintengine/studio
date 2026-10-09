import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { getWorkspaceChatOpener, setWorkspaceChatOpener, type WorkspaceChatOpener } from './chat-opener'
import { createRendererHost } from './renderer-host'

afterEach(() => setWorkspaceChatOpener(null))

test('no opener is registered until the shell sets one', () => {
  assert.equal(getWorkspaceChatOpener(), null)
})

test('the registered opener is the one handed back, and clearing it removes it', async () => {
  const calls: Parameters<WorkspaceChatOpener>[0][] = []
  const opener: WorkspaceChatOpener = async (input) => {
    calls.push(input)
    return { ok: true, agentId: 'chat-1' }
  }
  setWorkspaceChatOpener(opener)
  assert.equal(getWorkspaceChatOpener(), opener)

  const result = await getWorkspaceChatOpener()!({ moduleId: 'acme', workspaceId: 'ws-1', prompt: 'hello' })
  assert.deepEqual(result, { ok: true, agentId: 'chat-1' })
  assert.deepEqual(calls, [{ moduleId: 'acme', workspaceId: 'ws-1', prompt: 'hello' }])

  setWorkspaceChatOpener(null)
  assert.equal(getWorkspaceChatOpener(), null)
})

test('a later registration replaces the earlier one', () => {
  const first: WorkspaceChatOpener = async () => ({ ok: true, agentId: 'a' })
  const second: WorkspaceChatOpener = async () => ({ ok: true, agentId: 'b' })
  setWorkspaceChatOpener(first)
  setWorkspaceChatOpener(second)
  assert.equal(getWorkspaceChatOpener(), second)
})

function manifest(permissions: string[]): CapabilityManifest {
  return { id: 'acme', displayName: 'Acme', version: 1, defaultEnabled: true, source: 'third-party', permissions }
}

test('openChat refuses a module that declared neither chat:draft nor conversation:operate, before reaching the opener', async () => {
  let called = false
  setWorkspaceChatOpener(async () => {
    called = true
    return { ok: true, agentId: 'chat-1' }
  })
  const kernel = createRendererHost()
  for (const host of [kernel.hostFor('acme'), kernel.hostFor('acme', manifest(['conversation:read']))]) {
    const result = await host.openChat({ workspaceId: 'ws-1' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'permission_missing')
  }
  assert.equal(called, false)
})

test('chat:draft opens a draft, and only conversation:operate sends the prompt', async () => {
  const calls: Parameters<WorkspaceChatOpener>[0][] = []
  setWorkspaceChatOpener(async (input) => {
    calls.push(input)
    return { ok: true, agentId: 'chat-1' }
  })
  const kernel = createRendererHost()
  const drafter = kernel.hostFor('acme', manifest(['chat:draft']))
  assert.deepEqual(await drafter.openChat({ workspaceId: 'ws-1', prompt: 'Fix CI', name: 'Fix CI', dedupeKey: 'pr-12' }), {
    ok: true,
    agentId: 'chat-1',
  })
  const sent = await drafter.openChat({ workspaceId: 'ws-1', prompt: 'Fix CI', send: true })
  assert.equal(!sent.ok && sent.code, 'permission_missing')
  assert.match(!sent.ok ? sent.message : '', /conversation:operate/)
  const operator = kernel.hostFor('acme', manifest(['conversation:operate']))
  assert.equal((await operator.openChat({ workspaceId: 'ws-1', prompt: 'Fix CI', send: true })).ok, true)
  assert.deepEqual(
    calls.map((call) => [call.send ?? false, call.name ?? null, call.dedupeKey ?? null]),
    [
      [false, 'Fix CI', 'pr-12'],
      [true, null, null],
    ],
  )
})

test('openChat answers unavailable until the shell registers an opener', async () => {
  const host = createRendererHost().hostFor('acme', manifest(['conversation:operate']))
  const result = await host.openChat({ workspaceId: 'ws-1' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'unavailable')
})

test('openChat hands the registered opener the input stamped with the calling module', async () => {
  const calls: Parameters<WorkspaceChatOpener>[0][] = []
  setWorkspaceChatOpener(async (input) => {
    calls.push(input)
    return { ok: true, agentId: 'chat-7' }
  })
  const host = createRendererHost().hostFor('acme', manifest(['conversation:operate']))
  const result = await host.openChat({ workspaceId: 'ws-1', prompt: 'Review this', send: true })
  assert.deepEqual(result, { ok: true, agentId: 'chat-7' })
  assert.deepEqual(calls, [{ workspaceId: 'ws-1', prompt: 'Review this', send: true, moduleId: 'acme' }])
})

test("supports('chat.open') follows the shell's opener rather than a table", () => {
  const host = createRendererHost().hostFor('acme', manifest(['conversation:operate']))
  assert.equal(host.supports('chat.open'), false)
  assert.equal(host.supports('chat.open-options'), false)
  setWorkspaceChatOpener(async () => ({ ok: true, agentId: 'chat-1' }))
  assert.equal(host.supports('chat.open'), true)
  assert.equal(host.supports('chat.open-options'), true)
  setWorkspaceChatOpener(null)
  assert.equal(host.supports('chat.open'), false)
  assert.equal(host.supports('conversations'), true)
  assert.equal(host.supports('conversation-controls'), true)
  assert.equal(host.supports('secrets'), true)
  assert.equal(host.supports('github'), true)
  assert.equal(host.supports('not-a-capability'), false)
})
