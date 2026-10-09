import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired machine's send that names skills runs them here, resolved against
// this machine's folder as a chip in its own composer is.

test('a remote send hands its skills to the runtime', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-send-skills-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const resolved: string[][] = []
  const sent: string[][] = []
  const mock = createMockConversationProvider()
  const adapter: ConversationProviderAdapter = {
    ...mock,
    sendTurn(input) {
      sent.push(input.skills ?? [])
      return mock.sendTurn(input)
    },
  }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    resolveSkills: async ({ skills }) => {
      resolved.push(skills.map((skill) => skill.id))
      return { ids: skills.map((skill) => skill.id) }
    },
  })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
  )
  try {
    const started = await runtime.startSession({
      ...key,
      providerId: adapter.id,
      modelId: adapter.listModels()[0]!,
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
    const result = await host.command(key, 'phone', 'send-1', {
      kind: 'send',
      message: 'Find the flaky test',
      skills: ['systematic-debugging'],
    })
    assert.equal(result.ok, true, result.message ?? '')
    assert.deepEqual(resolved, [['systematic-debugging']])
    assert.deepEqual(sent, [['systematic-debugging']])
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
