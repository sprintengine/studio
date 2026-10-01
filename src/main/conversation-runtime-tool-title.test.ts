import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

test('streamed output keeps the running tool as the session line until the tool finishes', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-tool-title-'))
  const mock = createMockConversationProvider()
  let finish = false
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          const base = { sessionId: input.sessionId, workspaceId: input.workspaceId, agentId: input.agentId }
          const event = (type: 'turn_started' | 'tool_started' | 'tool_output', payload: Record<string, unknown>) => ({
            ...base,
            id: '',
            providerId: input.providerId,
            modelId: input.modelId,
            type,
            createdAt: 0,
            payload: { turnId: input.turnId, ...payload },
          })
          return [
            event('turn_started', {}),
            event('tool_started', { toolUseId: 'run', name: 'Bash', kind: 'command', input: { command: 'npm test' } }),
            event('tool_output', { toolUseId: 'run', output: 'PASS a.test.ts', partial: !finish }),
          ]
        },
      },
    ],
    getProviderById: () => undefined,
  })
  const title = () => {
    const listed = runtime.listSessions({ workspaceId: 'workspace' })
    return listed.ok ? listed.sessions[0]?.currentToolTitle : undefined
  }
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.ok(started.ok)
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'test' })).ok, true)
    for (let i = 0; i < 100 && !title(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(title(), 'the running command names the session line')
    await runtime.interrupt({ sessionId: started.session.sessionId })
    finish = true
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'again' })).ok, true)
    for (let i = 0; i < 100 && title(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(title(), undefined, 'a finished tool clears it')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
